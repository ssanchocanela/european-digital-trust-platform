# ADR 0009 — Cross-device presentation mitigations

- **Status:** ACCEPTED (Milestone 1)
- **Date:** 11 September 2026
- **Supersedes nothing.** Implements the mitigation obligation left open by
  [ADR 0005](0005-presentation-policy-abstraction-and-minimisation-first-compilation.md) Decision 6.
- **Numbered 0009**, the next free number: 0006 stays reserved for the hosted Relying Party Instance
  versus intermediary decision (blocked on legal input, open question Q2), and 0007–0008 for
  Milestone 2 issuance and credential status.

## Context

`EW-PIO-01-016` (`OIA_08c`) states that Wallet Units **SHOULD NOT** support a redirects-based
transmission mechanism for cross-device presentation flows. `EW-PIO-01-017` (`OIA_08d`) states that
a Relying Party which uses one anyway **SHALL** implement adequate mitigations for the challenges
described in "Section 4.4.3.1 of the ARF main document".

A QR code carrying an `openid4vp://` URI is exactly such a flow. The V0 plan keeps it in the API
surface, with `SAME_DEVICE` as the tested path. So the obligation applies and has to be met with
something, not merely flagged.

### The citation in `OIA_08d` is wrong

In ARF 3.0.0, **§4.4.3.1 is "Introduction"** — it describes how the transmission channel is set up
and lists where each flow is documented. It contains no challenges.

The challenges are in **§4.4.3.2, "Challenges for remote presentation flows using custom URIs"**.

This ADR therefore derives its mitigations from §4.4.3.2, and the discrepancy is recorded as a
baseline inconsistency in [`interop-findings.md`](../interop-findings.md) D6 and noted in
[`traceability.md`](../traceability.md). Following the citation literally would have produced no
mitigations at all, which is worth saying plainly: a wrong cross-reference in a `SHALL` requirement
is the kind of thing that silently becomes "nothing to do".

### What §4.4.3.2 actually lists

Five challenges. ARF's own answer to **all five** is to use the W3C Digital Credentials API
instead — which §4.4.3.3–§4.4.3.5 then describe, and which is out of V0 scope. So the real question
for each is narrower: *what can a Relying Party do about this with custom URIs?*

| # | Challenge | Can a Relying Party address it? |
|---|---|---|
| 1 | **Secure cross-device flows** — phishing and relay attacks; ARF says OS-managed proximity checks mitigate them | **Partly.** The proximity check needs the DC API and CTAP, which only the browser and OS provide. An RP can shrink the window the attack has |
| 2 | **Wallet Unit selection** — the user may be unable to choose the right Wallet Unit | **No.** Needs the unified browser/OS interface |
| 3 | **Invocation mechanism** — custom-URI invocation is inconsistent across browsers and OSes | **No.** Not an RP-side property |
| 4 | **Clear origin verification** — the Wallet needs the Relying Party Instance's origin to resist relay attacks | **Partly.** A redirect flow has no browser-supplied origin. An RP can instead guarantee the request is cryptographically attributable for its whole life |
| 5 | **Session binding** — context switching can enable session hijacking | **Yes.** An RP controls what comes back through the interaction channel and who may read the result |

Two of five are addressable, one partly, two not at all.

## Decision

Implement the four mitigations below for `interactionType: "QR"`, and **do not claim `OIA_08d` is
satisfied**. The unmitigated challenges are carried in the audit record of every cross-device
transaction and listed as residual risk in
[`security-limitations.md`](../security-limitations.md) P1.

Implemented in `packages/domain/src/verification/cross-device.ts`, applied by
`PresentationService.create`, and tested in `tests/unit/cross-device.test.ts` and
`tests/integration/verification-flow.test.ts`.

### `QR_SHORT_LIFETIME` — challenge 1

A cross-device transaction lifetime is capped at **120 seconds**, against a 300-second same-device
default, whatever the policy configures. The engine already enforces single use, so a captured URI
is worthless once consumed; this bounds how long it remains usable before that.

There is no specified value to cite — ARF names the challenge, not a number — so this is a platform
choice: long enough to pick up a phone, scan and approve; short enough that a phished or relayed URI
goes stale quickly. It is a parameter, not a constant of nature, and a deployment may lower it.

### `QR_REQUESTER_AUTHENTICATED` — challenge 4

A QR transaction is **refused** when the access certificate would expire inside the transaction
lifetime (`access_certificate_expires_during_transaction`, HTTP 409).

With no browser-supplied origin, the signed request object and its access certificate are the only
means by which a Wallet can attribute the request at all. Allowing a live request whose certificate
lapses part-way through would leave a window in which it is unattributable — which is precisely the
relay surface challenge 4 describes. Refusing is the correct outcome; the alternative is a request
that is live but unverifiable.

This is **stricter than the same-device path**, deliberately: same-device has the browser context
that cross-device lacks.

### `QR_NO_RESULT_VIA_INTERACTION_CHANNEL` — challenge 5

No completion redirect is passed to the engine for a QR transaction. The platform uses the engine's
cross-device URI variant, which carries none, so **nothing is returned to whichever device followed
the URI**.

The settled result is reachable only through the authenticated business API, which binds it to the
tenant that created the transaction rather than to whoever scanned the code. That is the session
binding available to a Relying Party in a custom-URI flow: it does not prevent a hijacked *context*,
but it prevents a hijacked context from *learning the outcome*.

### `QR_EXPLICIT_OPT_IN_AUDITED`

Not a challenge from §4.4.3.2, but a precondition for the rest being meaningful. `SAME_DEVICE` is
the default; `QR` must be requested per transaction, and each use emits a
`platform.interaction.cross_device_requested` audit event carrying the mitigations applied **and the
residual risks**. The discouraged flow cannot be adopted silently, and the residual risk lives in
the evidence rather than only in a document someone may not read.

## Residual risk — explicitly not closed

| Residual | Challenge | Why it cannot be closed here |
|---|---|---|
| `NO_PROXIMITY_CHECK` | 1 | Requires the DC API and CTAP; only the browser and OS can perform it — `EW-PIO-01-020` (`OIA_08g`) |
| `NO_UNIFIED_WALLET_SELECTION` | 2 | Requires the browser/OS credential chooser |
| `INCONSISTENT_INVOCATION` | 3 | A property of custom-URI handling across platforms |
| `NO_BROWSER_SUPPLIED_ORIGIN` | 4 | A redirect flow has no origin for the Wallet to check |

**Therefore: `OIA_08d` is not met.** `SAME_DEVICE` remains the tested and recommended path, and
`QR` is available-but-flagged. Nothing in the code, the API documentation or the traceability matrix
states otherwise.

A related fact, verified rather than assumed: the pinned Reference Implementation release **does
still scan `openid4vp://` QR codes** — `QrScanViewModel.navigateToPresentationRequest` passes the
scanned string to `PresentationMode.OpenId4Vp(uri = scanResult)`. So the flow is reachable in
practice, which is why mitigating it matters rather than relying on the wallet to refuse.

## Consequences

- **Positive.** The obligation is addressed with real behaviour rather than a disclaimer, and the
  honest gap is recorded in three places that a reader cannot miss: the audit record, the
  limitations document and the traceability matrix.
- **Positive.** The residual set is asserted non-empty by a test, so a future change cannot quietly
  empty it and start implying conformance.
- **Negative.** A 120-second cap may be too short for some users. It is configurable downward but
  not upward, which is the right asymmetry for a discouraged flow; a deployment needing longer
  should use the DC API instead.
- **Negative.** `QR_REQUESTER_AUTHENTICATED` will reject transactions that `SAME_DEVICE` accepts,
  near certificate expiry. That asymmetry is intentional and is documented in the API reference.
- **Next iteration.** W3C Digital Credentials API support is planned as **the iteration after
  Milestone 1**, and it is what actually closes challenges 1–4. Until then, this ADR is a floor,
  not a solution.

## Status of claims

No conformance with ARF 3.0.0 or any Technical Specification is claimed, and specifically **no claim
is made that `EW-PIO-01-017` (`OIA_08d`) is satisfied**. HLR identifiers were read from
`hltr/high-level-requirements.csv` at ARF commit `c64f2cbb19aee37c571c58af66d359c4d5be29c8`; ARF
section numbers refer to `docs/main/04-high-level-architecture.md` at that commit.
