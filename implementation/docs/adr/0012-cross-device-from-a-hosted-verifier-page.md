# ADR 0012 — Cross-device presentation from a hosted verifier page, for the bank onboarding demonstration

- **Status:** ACCEPTED, 5 October 2026: the user chose it over a same-device-only demonstration.
  **Not yet exercised with a wallet.**
- **Date:** 5 October 2026
- **Amends:** [ADR 0009](0009-cross-device-presentation-mitigations.md), which keeps `QR` in the
  business API and says it is never the demonstrated flow.
- **Numbered 0012**, the next free number (0006 stays reserved; 0007–0008 are Milestone 2).

## Context

The bank onboarding demonstration (`apps/demo-onboarding`, "Banco Horizonte") is presented from a
desktop screen: the bank's page in a browser, the wallet on a phone, and at its centre a split screen
where today's onboarding, simulated, runs beside the wallet one. A phone cannot open a wallet from a
page on another device except by a QR code carrying the `openid4vp://` URI — the cross-device flow
`EW-PIO-01-016` (`OIA_08c`) discourages and ADR 0009 mitigates without claiming `EW-PIO-01-017`
(`OIA_08d`).

Until now the hosted verifier — the narrow route a public demonstration page uses in place of a tenant
key — created `SAME_DEVICE` presentations only, and returned the wallet to one configured origin.

## Decision

1. **The hosted verifier may create a `QR` presentation, for the policies configuration names.**
   `HOSTED_VERIFIER_QR_POLICIES` lists them by id. A page asking for `QR` under any other policy is
   refused (`hosted_verifier_cross_device_not_allowed`, 403), and a page that asks for nothing gets
   `SAME_DEVICE`, as before. The opening is per policy and made by the operator; a page cannot ask
   its way into it.

2. **Every ADR 0009 mitigation applies unchanged**, because the presentation is created by the same
   `PresentationService.create`: the 120-second lifetime, the refusal when the access certificate
   would lapse inside it, no completion redirect, and the audit record with the residual risks.

3. **The page keeps `QR_NO_RESULT_VIA_INTERACTION_CHANNEL` meaningful.** ADR 0009 binds a `QR`
   outcome to the authenticated tenant. A hosted verifier page authenticates with its one secret and
   then serves a browser, so the page must not release the outcome for a presentation id alone:
   `apps/demo-onboarding` gives the browser that asked a token (an HMAC under a per-process key) and
   answers a poll for a `QR` presentation only with it. The device that scanned the code gets
   nothing, from the platform or from the page.

4. **A hosted verifier page may have an origin of its own.** `HOSTED_VERIFIER_ORIGINS` maps a policy
   to the origin its same-device return goes to; a policy not named keeps
   `HOSTED_VERIFIER_PUBLIC_URL`. Configuration, as that one is: nothing a visitor or the page sends
   chooses the redirect.

5. **What may be said changes in one respect only.** The bank onboarding demonstration may be shown
   with its QR code. It is then described as what it is: a cross-device flow the ARF discourages,
   with four mitigations and four residual risks, and `OIA_08d` not met. `SAME_DEVICE` stays the
   tested default everywhere else, and stays this demonstration's flow on a phone.

## Consequences

- **Positive.** The demonstration can be given the way a room expects, without a tenant key in a
  public process and without a second way to create presentations.
- **Negative.** A public page can now make the platform create presentations of the discouraged kind,
  within the page's rate limit (10 a minute per client). Each is audited with its residual risks.
- **Negative.** The token is in the memory of one process. A restart forgets which presentations
  were cross-device; those — two minutes long at most — then answer to their id, as a same-device
  one does. Recorded in [`security-limitations.md`](../security-limitations.md) P12.
- **Negative.** The onboarding page shares `HOSTED_VERIFIER_SECRET` with the demonstration bank, so
  either process could ask for the other's policies. One secret per page is the fix, not made here.
- **Unchanged.** The residual risks of ADR 0009. This ADR closes none of them.

## Status of claims

No conformance with ARF 3.0.0 or any Technical Specification is claimed, and specifically **no claim
is made that `EW-PIO-01-017` (`OIA_08d`) is satisfied**. HLR identifiers as cited in ADR 0009, read
from `hltr/high-level-requirements.csv` at ARF commit `c64f2cbb19aee37c571c58af66d359c4d5be29c8`.
