# OpenID Foundation conformance suite: results

**Run on 11 September 2026**, self-hosted, tightest profile. Approved in review A.2.

| | |
|---|---|
| Suite | `gitlab.com/openid/conformance-suite`, commit `e3b5558d6d5e0c17ab578a47b955fd3b405f902b` (2026-09-10), prebuilt images `registry.gitlab.com/openid/conformance-suite{,/nginx}:latest` |
| Plan | `oid4vp-1final-verifier-haip-test-plan` |
| Variants resolved | `credential_format: sd_jwt_vc`, `response_mode: direct_post.jwt`, `client_id_prefix: x509_hash`, `request_method: request_uri_signed`, `vp_profile: haip` |
| Module run | `oid4vp-1final-verifier-happy-flow` |
| Under test | EUDIPLO `v7.6.0` (`sha256:8dd60a2f…`), platform commit `0f86592`, migrations 0000–0004 |
| Result | **FINISHED** — 54 `SUCCESS`, 4 `FAILURE`, 1 `WARNING`, 8 `INFO` (85 entries) |

**No ARF or TS conformance is claimed.** This suite tests OpenID4VP 1.0 Final and HAIP, not the ARF's
high-level requirements. A green run would say our protocol artefacts are well-formed against an
independent implementation — nothing about `RPRC_19`, the issuer-trust gates, or whether a Wallet Unit
would accept our certificates.

---

## One correction to the earlier evaluation

The evaluation flagged an open question: *whether the VP verifier plan can drive a verifier using
`x509_hash` with a self-signed certificate, or whether it insists on a chain it can validate.*

**Answered: it can.** The plan takes `client.request_object_trust_anchor_pem`, so the suite validates
our signed request object against an anchor **we supply**. Feeding it our own development certificate
is enough to run the plan. That is what makes this evidence independent of blocker B1 — the suite
trusts what we tell it to, and then checks everything else properly.

## What passed — the substantive part

54 checks, independently verified. The ones worth naming, because our own tests can only assert them:

| Area | Confirmed |
|---|---|
| Request object | `typ` header valid; `exp`, `iat`, `aud` valid; no `request`/`request_uri` nesting; no `iss`; `client_id` matches between parameter and object |
| `x509_hash` prefix | `client_id` matched against the certificate; `client_id_scheme` correctly **absent** (it is superseded by the prefix) |
| Response mode | `direct_post.jwt`; `request_uri_method` is `get` |
| Nonce | URL-safe, ≥16 and ≤43 characters, **sufficient entropy** |
| Response encryption | `client_metadata.jwks` holds valid encryption keys with `alg`; unique `kid`s; **public key material only**; supported key type, curve and algorithm; "satisfies HAIP & OID4VP requirements" |
| **Ephemeral keys** | *"Verifier response-encryption key(s) were not seen in a previous Authorization Request"* — independent confirmation that a fresh encryption key is generated per request, which is a privacy property we had only asserted |
| DCQL | Valid; no unknown properties; **"does not request any SD-JWT VC claims that cannot be selectively disclosed"**; no unreferenced `claims` entries; format matches configuration |
| Hygiene | No `redirect_uri`; no `presentation_definition`; no `transaction_data`; no `scope`; all parameters expected |

The DCQL selective-disclosure check is the nicest result: it independently confirms that the compiler's
claim-path handling produces a query a Wallet can satisfy *selectively*, which is the whole point of
minimisation and something we could previously only reason about.

Also recorded by the suite, three times: *"Skipped evaluation due to missing required element:
`effective_authorization_endpoint_request verifier_info`"* — an independent observation of engine gap
**G2**, from a tool that had never heard of our register.

## What failed — classified

| # | Failure | Classification |
|---|---|---|
| 1 | `The scheme used in the request_uri value MUST be https` | **Test-harness environment.** Our `ENGINE_PUBLIC_URL` was `http://eudiplo:3000` so the suite's container could fetch it. The underlying requirement is real and already tracked as blocker **B5** (a phone or any conformant wallet needs public HTTPS). Not a new defect |
| 2 | `response_uri scheme is not https` | Same cause as #1 |
| 3 | `Leaf certificate in x5c chain must not be self-signed` | **Known blocker B1**, independently confirmed. Our development certificate is self-signed; a real Access CA certificate fixes it. Not a new defect — and the suite still ran the whole flow, which is the point |
| 4 | `…/oid4vp endpoint returned an unexpected http status` — 400, expected 200 | **Correct behaviour, not a defect.** The engine answered `400` with *"The credential could not be verified."* The suite presents a credential signed by **its own** key, for which our engine holds no trust anchor, so refusing it is right. To exercise the accept path the engine would need the suite's issuer certificate as a trust anchor — a deliberate configuration step, recorded below as the next run |

### The one genuinely new finding — engine gap G7

| | |
|---|---|
| `WARNING` | *Direct post response object contains unexpected keys* (`OID4VP-1FINAL-8.2`) |

The engine's response to the `direct_post.jwt` POST was:

```json
{ "statusCode": 400,
  "timestamp": "2026-09-11T19:00:07.884Z",
  "path": "/presentations/…/oid4vp",
  "redirect_uri": "http://localhost:3100/v1/presentations/…/return?error=invalid_request&…" }
```

`statusCode`, `timestamp` and `path` are the engine's **generic NestJS error envelope leaking into a
protocol response**. OpenID4VP §8.2 defines what this response may contain; a Wallet parsing it strictly
could be confused by the extra keys, and `path` discloses internal routing.

This is an engine defect rather than a platform one — the platform never sees or shapes this response —
and it is now **G7** in the engine gap register. It is the kind of thing only an adversarial peer finds:
our own contract tests assert on the engine's *management* API and on request objects, never on what the
engine returns to a wallet on the error path.

## What the run did **not** do

- **No outbound traffic.** Tightest profile: the suite and our stack on one Docker network, images
  pre-pulled. The `localhost.emobix.co.uk` DNS lookup is avoided entirely by the prebuilt compose file,
  which aliases that name to its own nginx container — better than the inventory assumed.
- **The `oid4vci-1_0-issuer-haip-test-plan` has not been run.** The verifier plan came first by
  recommendation; the issuer plan is the next step.
- **The other 11 verifier modules have not been run** — nine of them negative tests
  (`invalid-credential-signature`, `invalid-sd-hash`, `invalid-kb-jwt-nonce`, `invalid-kb-jwt-aud`,
  `kb-jwt-iat-in-past`/`-future`, `invalid-session-transcript`, `minimal-cnf-jwk`,
  `request-uri-method-post`, `request-uri-fetched-twice`). These are the most valuable remaining
  evidence, because they test that we *reject* what we should.

## Next run, faithful profile

**Now prepared in full:** [`conformance-faithful-profile.md`](conformance-faithful-profile.md) —
the three setup steps, the two configuration keys that were wrong twice, the 11 remaining verifier
modules with what each one asserts, and the egress decision. Summarised here:

Three changes, in order of value:

1. **Configure the suite's issuer certificate as an engine trust anchor**, so failure #4 becomes a
   `200` and the accept path is exercised. Without this, every module that expects a successful
   presentation will stop at the same point.
2. **Serve the engine over HTTPS** with a certificate the suite trusts, clearing failures #1 and #2.
   This is blocker **B5** work and is needed for a phone test anyway.
3. **Run the remaining 11 modules**, then `oid4vci-1_0-issuer-haip-test-plan`.

A real Access CA certificate (Path A) would clear #3 as well, at which point the plan should pass
cleanly — and *that* would be meaningful interoperability evidence, still short of ARF conformance.

## Corrections to the outbound-URL inventory

Two things the inventory got wrong, recorded because an inventory nobody corrects is worse than none:

- **`registry.gitlab.com` was missing.** Prebuilt images come from the GitLab container registry, a
  different host from `gitlab.com`. Three images: the suite, its nginx, and `mongo:6.0.13`.
- **`localhost.emobix.co.uk` needs no DNS at runtime.** `docker-compose-prebuilt.yml` declares it as a
  network alias for the nginx container, so resolution is internal. The inventory assumed an external
  lookup and suggested an `/etc/hosts` entry; neither is needed.
