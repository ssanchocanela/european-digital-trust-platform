# DRAFT — not filed

An upstream issue for [OpenWallet Foundation / EUDIPLO](https://github.com/openwallet-foundation/eudiplo),
drafted on 11 September 2026. **It has not been submitted.** Filing is a human decision.

---

**Title:** The generic error envelope leaks into the OpenID4VP `direct_post` response

**Version:** `v7.6.0` (image digest
`sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667`)

**Found by:** the OpenID Foundation conformance suite (commit `e3b5558d`), plan
`oid4vp-1final-verifier-haip-test-plan`, module `oid4vp-1final-verifier-happy-flow`, which reported
*"Direct post response object contains unexpected keys"* against `OID4VP-1FINAL-8.2`.

## Summary

When a presentation fails, `POST /presentations/{sessionId}/oid4vp` answers with the application's
generic NestJS error envelope rather than a response shaped by OpenID4VP:

```json
{
  "statusCode": 400,
  "timestamp": "2026-09-11T19:00:07.884Z",
  "path": "/presentations/3f…/oid4vp",
  "redirect_uri": "https://verifier.example/v1/presentations/3f…/return?error=invalid_request&…"
}
```

`redirect_uri` is correct and is what a Wallet needs. The other three members are not part of this
response.

## Why it matters

1. **OpenID4VP 1.0 Final §8.2** defines what the response to a `direct_post` / `direct_post.jwt`
   submission may contain. A Wallet that validates the response strictly — and a conformance suite
   does — sees members the specification does not define here.
2. **`path` discloses internal routing**, including the session identifier, in a response that crosses
   a trust boundary to a Wallet. Of the three it is the one with a security flavour rather than a
   tidiness one.
3. There is **no `error` or `error_description`** in the body, so a Wallet that wants to tell the User
   *why* the presentation failed has only the `redirect_uri` query string to work from.

## Reproduction

1. Configure a verifier and create a presentation session.
2. Post a `vp_token` the engine cannot verify — for example a credential signed by a key for which the
   tenant holds no trust anchor.
3. Observe the `400` response body.

The conformance suite reproduces it as a side effect of its happy-flow module, because the credential it
presents is signed by its own key.

## Suggested fix

Shape this response in the OpenID4VP error form rather than the application's generic one:

- keep `redirect_uri`;
- add `error` and, where it can be said without disclosing internals, `error_description`;
- drop `statusCode`, `timestamp` and `path`.

Concretely, an exception filter scoped to the wallet-facing protocol routes, rather than the global one.
The Protocol API and the Management API are already distinct surfaces on the same port (the latter under
`/api`), so the split exists and this is a matter of which filter applies where. The Management API's
envelope is useful and should keep it — a generic envelope is right for an administrative API and wrong
for a protocol endpoint.

Worth checking the same way: `POST /presentations/{sessionId}/iso-18013-7` and the OpenID4VCI error
paths (`/issuers/{tenantId}/vci/credential`, `/authorize/token`), which OpenID4VCI §7.3 and OAuth 2.0
also constrain. We have not tested those, so this issue does not claim anything about them.

## Severity

**Low, but real.** A Wallet should tolerate unknown members, and the disclosure is a route and a session
id rather than a secret. We are not aware of it breaking any Wallet.

## Impact on us, and our workaround

None required, and none taken. The response is generated entirely by the engine — the platform never sees
or shapes it — so there is nothing for us to fix and nothing we can fix without inserting ourselves into
the engine's protocol surface, which our architecture exists to avoid.

We evaluated stripping the three members at our edge gateway and **decided against it as a default**. The
reason is worth stating because it is about evidence rather than effort: with stripping on, a conformance
run through our gateway would report this as absent when it is not, and the value of running that suite is
that it describes the engine as it is. The option exists, off by default, and is forbidden during any
conformance run or any run whose purpose is to evidence an engine gap.

Recorded as gap **G7** in our engine gap register.

## A note on how this was found

Our own contract tests assert on the engine's *management* API and on the request objects it produces for
a Wallet. They never look at what the engine returns to a Wallet on an error path, which is precisely
where this lives. It took an adversarial independent peer to see it — which is the argument for running
the suite, and the reason we are passing the finding upstream rather than only recording it.
